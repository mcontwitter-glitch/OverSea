// Simulates thirdweb's mobile redirect return (?walletId=inApp&authProvider=x&state=..&authResult=..) with a FAKE
// auth result: the app must hand it to thirdweb's autoConnect (params stripped from the URL) and show a visible
// error instead of silently showing no wallet. BASE=http://localhost:4331 node scripts/shots-social-return.mjs
import { chromium, devices } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:4331';
const b = await chromium.launch(); const ctx = await b.newContext(devices['iPhone 13']); const p = await ctx.newPage();
const S = 'abcdef0123456789abcdef0123456789';
await ctx.addInitScript(s => localStorage.setItem('thirdweb:auth-redirect-state:' + s, String(Date.now() + 6e5)), S);
const fake = encodeURIComponent(JSON.stringify({ storedToken: { jwtToken: 'x', authProvider: 'X', authDetails: { userWalletId: 'u' }, developerClientId: 'c', cookieString: 'x', shouldStoreCookieString: false, isNewUser: false }, walletDetails: { walletAddress: '0x0000000000000000000000000000000000000001' } }));
const logs = []; p.on('console', m => { if (m.type() === 'error') logs.push(m.text().slice(0, 160)); });
await p.goto(`${BASE}/c/lil-foots/?walletId=inApp&authProvider=x&state=${S}&authResult=${fake}`);
const shown = await p.waitForSelector('text=Sign-in failed', { timeout: 45000 }).then(() => true, () => false);
const url = p.url(); await p.screenshot({ path: 'screens/social-return/fake-return-mobile.png' });
const ok = shown && !/authResult|walletId|state=/.test(url);
console.log(JSON.stringify({ errorShown: shown, urlCleaned: !/authResult/.test(url), err: await p.locator('.err').first().textContent().catch(() => null), logs: logs.filter(l => /social/.test(l)) }));
await b.close(); console.log(ok ? 'ALL PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
