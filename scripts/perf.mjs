// Time until the first 8 card images are visible (decoded) at 390x844 on throttled "Slow 4G" (Lighthouse mobile: 150ms RTT, 1.6Mbps down, 750kbps up), cold cache.
import { chromium } from 'playwright';
const U = process.argv[2] || 'https://multisea.io/'; const runs = +(process.argv[3] || 3);
const b = await chromium.launch(); const res = [];
for (let r = 0; r < runs; r++) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true });
  const p = await ctx.newPage(); const cdp = await ctx.newCDPSession(p);
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
  let bytes = 0; p.on('response', async x => { const l = +(x.headers()['content-length'] || 0); bytes += l; });
  const t0 = Date.now();
  await p.goto(U + (U.includes('?') ? '&' : '?') + 'r=' + Math.random(), { waitUntil: 'commit' });
  const t = await p.waitForFunction(() => { const im = [...document.querySelectorAll('.card .ci img')].slice(0, 8); return im.length === 8 && im.every(i => i.complete && i.naturalWidth > 0) ? performance.now() : false; }, null, { timeout: 120000, polling: 100 }).then(h => h.jsonValue()).catch(() => null);
  const firstCard = await p.evaluate(() => performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint')?.startTime);
  res.push({ first8: t && Math.round(t), fcp: firstCard && Math.round(firstCard), wall: Date.now() - t0 });
  await ctx.close();
}
console.log(U, JSON.stringify(res), 'median first8 ms:', res.map(x => x.first8).sort((a, b) => a - b)[Math.floor(res.length / 2)]);
await b.close();
