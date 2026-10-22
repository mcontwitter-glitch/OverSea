// Read-only: is each launchpad testnet contract source-verified? Etherscan V2 (key from ETHERSCAN_ENV, never printed) / Sourcify (Robinhood testnet).
import fs from 'node:fs';
const S = JSON.parse(fs.readFileSync(new URL('../deployments/launchpad-testnet.json', import.meta.url)));
const T = JSON.parse(fs.readFileSync(new URL('../../config/launchpad.testnet.json', import.meta.url)));
const env = fs.readFileSync(process.env.ETHERSCAN_ENV || '/workspace/foot-wallets/contracts/.etherscan.env', 'utf8'); const KEY = (env.match(/ETHERSCAN_API_KEY=(.*)/) || [])[1]?.trim().replace(/^["']|["']$/g, '');
const out = {};
for (const [k, d] of Object.entries(S.chains)) { if (!d.factory) continue; out[k] = {};
  for (const n of ['timelock', 'dropImpl', 'omniImpl', 'escrow', 'factory']) { const a = d[n]; let ok = false, name = '';
    try { if (k === 'robinhoodTestnet') { const j = await fetch(`https://sourcify.dev/server/v2/contract/46630/${a}`).then(r => r.json()); ok = j.match === 'match' || j.match === 'exact_match'; name = ok ? 'Sourcify ' + j.match : ''; }
      else { const j = await fetch(`https://api.etherscan.io/v2/api?chainid=${T.chains[k].chainId}&module=contract&action=getsourcecode&address=${a}&apikey=${KEY}`).then(r => r.json()); name = j.result?.[0]?.ContractName || ''; ok = !!name; } } catch (e) { name = 'ERR ' + e.message; }
    await new Promise(r => setTimeout(r, 450)); out[k][n] = { address: a, verified: ok, name }; console.log(k.padEnd(17), n.padEnd(9), a, ok ? 'VERIFIED ' + name : 'not verified ' + name); } }
fs.writeFileSync(new URL('../deployments/launchpad-testnet-verified.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
