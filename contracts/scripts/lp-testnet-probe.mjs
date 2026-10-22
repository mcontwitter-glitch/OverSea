// Read-only: probe LayerZero V2 testnet endpoints + default ULN (DVN) configs for every launchpad pathway.
import { createPublicClient, http, parseAbi, decodeAbiParameters } from 'viem';
import fs from 'node:fs';
const T = JSON.parse(fs.readFileSync(new URL('../../config/launchpad.testnet.json', import.meta.url)));
const E = parseAbi(['function eid() view returns (uint32)', 'function isSupportedEid(uint32) view returns (bool)', 'function defaultSendLibrary(uint32) view returns (address)', 'function defaultReceiveLibrary(uint32) view returns (address)',
  'function getConfig(address,address,uint32,uint32) view returns (bytes)']);
const ULN = [{ type: 'tuple', components: [{ name: 'confirmations', type: 'uint64' }, { name: 'requiredDVNCount', type: 'uint8' }, { name: 'optionalDVNCount', type: 'uint8' }, { name: 'optionalDVNThreshold', type: 'uint8' }, { name: 'requiredDVNs', type: 'address[]' }, { name: 'optionalDVNs', type: 'address[]' }] }];
const out = {};
for (const [k, c] of Object.entries(T.chains)) {
  const pub = createPublicClient({ transport: http(c.rpc) });
  const r = (f, a = []) => pub.readContract({ address: c.endpoint, abi: E, functionName: f, args: a });
  let eid; try { eid = await r('eid'); } catch (e) { console.log(k, 'endpoint eid() FAILED', e.shortMessage); continue; }
  console.log(`${k} endpoint ${c.endpoint} eid=${eid} (config ${c.eid})`); out[k] = {};
  for (const [k2, c2] of Object.entries(T.chains)) { if (k2 === k) continue;
    try { const sup = await r('isSupportedEid', [c2.eid]); if (!sup) { console.log(`  -> ${k2}: NOT supported`); out[k][k2] = null; continue; }
      const sl = await r('defaultSendLibrary', [c2.eid]), rl = await r('defaultReceiveLibrary', [c2.eid]);
      const [s] = decodeAbiParameters(ULN, await r('getConfig', ['0x0000000000000000000000000000000000000000', sl, c2.eid, 2]));
      const [v] = decodeAbiParameters(ULN, await r('getConfig', ['0x0000000000000000000000000000000000000000', rl, c2.eid, 2]));
      out[k][k2] = { sendLib: sl, receiveLib: rl, send: { confirmations: Number(s.confirmations), dvns: s.requiredDVNs }, receive: { confirmations: Number(v.confirmations), dvns: v.requiredDVNs } };
      console.log(`  -> ${k2}: send ${sl} conf=${s.confirmations} dvns=${s.requiredDVNs.join(',')} | recv ${rl} conf=${v.confirmations} dvns=${v.requiredDVNs.join(',')}`);
    } catch (e) { console.log(`  -> ${k2}: ERR ${e.shortMessage || e.message}`); out[k][k2] = null; } }
}
fs.writeFileSync(new URL('../deployments/lz-testnet-probe.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
