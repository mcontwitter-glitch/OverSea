// PREVIEW ONLY. Serves ../dist, proxies /rpc/<chain> to the local anvil forks (read + sendRawTransaction only),
// and simulates LayerZero delivery + the deployer bot on the forks:
//  - PacketSent from a MultiSea escrow -> lzReceive on the destination escrow (as the destination EndpointV2)
//  - Listed on a factory -> deploy mirrors + wire peers (scripts/deploy-bridge.mjs processListing)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { CFG, ROOT, art, loadDep, clients, eventsOf, PACKET_ABI } from './lib.mjs';
import { processListing } from './deploy-bridge.mjs';
import { createWalletClient, http as vhttp, slice, parseEther, decodeEventLog } from 'viem';
const DIST = path.resolve(ROOT, '../dist'); const PORT = +(process.env.PORT || 4180);
const E = art('MultiSeaEscrow'), F = art('MultiSeaFactory');
const ALLOW = /^(eth_(chainId|blockNumber|call|estimateGas|gasPrice|maxPriorityFeePerGas|feeHistory|getBalance|getCode|getLogs|getTransactionByHash|getTransactionReceipt|getTransactionCount|getBlockByNumber|getBlockByHash|sendRawTransaction|getStorageAt)|net_version|web3_clientVersion)$/;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function exportCfg() { execFileSync('node', ['scripts/export-frontend.mjs'], { cwd: ROOT, env: { ...process.env, PREVIEW: '1', MODE: 'fork', OUT: '../dist/bridge.json' } }); }
exportCfg();
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/rpc\/(\w+)$/);
  if (m && req.method === 'POST' && CFG.chains[m[1]]) {
    let body = ''; for await (const c of req) { body += c; if (body.length > 1e6) return res.end(); }
    let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
    const bad = (Array.isArray(j) ? j : [j]).some(x => !ALLOW.test(x.method));
    if (bad) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? null, error: { code: -32601, message: 'method not allowed on preview RPC' } })); }
    const r = await fetch(CFG.chains[m[1]].forkRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(await r.text());
  }
  let f = path.join(DIST, decodeURIComponent(u.pathname));
  if (!f.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) f = path.join(DIST, '404.html');
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log('preview on :' + PORT));

// ---- simulated LayerZero executor + deployer bot (forks only)
const last = {}; const done = new Set();
async function tick() {
  const dep = loadDep();
  const escrows = new Map(); for (const l of Object.values(dep.listings || {})) for (const [k, a] of Object.entries(l.escrows)) escrows.set(a.toLowerCase(), k);
  for (const key of Object.keys(CFG.chains)) {
    const { pub } = clients(key); const head = await pub.getBlockNumber(); const from = last[key] ?? head; last[key] = head + 1n; if (from > head) continue;
    const logs = await pub.getLogs({ fromBlock: from, toBlock: head });
    for (const lg of logs) {
      const id = lg.transactionHash + lg.logIndex; if (done.has(id)) continue;
      let ev; try { ev = decodeEventLog({ abi: [...PACKET_ABI, ...F.abi], data: lg.data, topics: lg.topics }); } catch { continue; }
      if (ev.eventName === 'Listed' && lg.address.toLowerCase() === dep.chains[key]?.factory?.toLowerCase()) {
        done.add(id); console.log('Listed on', key, 'id', ev.args.id); await processListing(key, ev.args.id); exportCfg(); continue;
      }
      if (ev.eventName !== 'PacketSent') continue;
      const p = ev.args.encodedPayload; const sender = '0x' + slice(p, 13, 45).slice(26); const dstEid = Number(BigInt(slice(p, 45, 49)));
      if (!escrows.has(sender.toLowerCase())) continue;
      done.add(id);
      const dstKey = Object.keys(CFG.chains).find(k => CFG.chains[k].eid === dstEid); const receiver = '0x' + slice(p, 49, 81).slice(26);
      const nonce = BigInt(slice(p, 1, 9)), srcEid = Number(BigInt(slice(p, 9, 13))), guid = slice(p, 81, 113), message = slice(p, 113);
      const dst = clients(dstKey); const ep = CFG.chains[dstKey].endpoint;
      await dst.pub.request({ method: 'anvil_impersonateAccount', params: [ep] });
      await dst.pub.request({ method: 'anvil_setBalance', params: [ep, '0x' + parseEther('1').toString(16)] });
      const w = createWalletClient({ chain: dst.chain, transport: vhttp(dst.rpc), account: ep });
      const hash = await w.writeContract({ address: receiver, abi: E.abi, functionName: 'lzReceive', args: [{ srcEid, sender: slice(p, 13, 45), nonce }, guid, message, ep, '0x'], gas: 600000n });
      const r = await dst.pub.waitForTransactionReceipt({ hash }); console.log('delivered', guid.slice(0, 12), key, '->', dstKey, r.status);
    }
  }
}
setInterval(() => tick().catch(e => console.log('tick error', e.shortMessage || e.message)), 2500);
