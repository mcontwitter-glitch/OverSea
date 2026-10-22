// READ-ONLY: LayerZero V2 mainnet pathway check for the 5 launchpad chains: isSupportedEid, default DVNs/confirmations,
// executor + nativeCap (can a non-Base mint prepay the hub's reply?). Writes /tmp/est/lz-mainnet.json.
import fs from 'node:fs'; import { createPublicClient, http, parseAbi, decodeAbiParameters } from 'viem';
export const MAIN = {
  base: { chainId: 8453, eid: 30184, rpc: 'https://mainnet.base.org', endpoint: '0x1a44076050125825900e736c501f859c50fE728c', native: 'ETH' },
  ethereum: { chainId: 1, eid: 30101, rpc: 'https://ethereum-rpc.publicnode.com', endpoint: '0x1a44076050125825900e736c501f859c50fE728c', native: 'ETH' },
  apechain: { chainId: 33139, eid: 30312, rpc: 'https://rpc.apechain.com/http', endpoint: '0x6F475642a6e85809B1c36Fa62763669b1b48DD5B', native: 'APE' },
  bnb: { chainId: 56, eid: 30102, rpc: 'https://bsc-rpc.publicnode.com', endpoint: '0x1a44076050125825900e736c501f859c50fE728c', native: 'BNB' },
  robinhood: { chainId: 4663, eid: 30416, rpc: 'https://rpc.mainnet.chain.robinhood.com', endpoint: '0x6F475642a6e85809B1c36Fa62763669b1b48DD5B', native: 'ETH' },
};
const E = parseAbi(['function eid() view returns (uint32)', 'function isSupportedEid(uint32) view returns (bool)', 'function defaultSendLibrary(uint32) view returns (address)', 'function defaultReceiveLibrary(uint32) view returns (address)', 'function getConfig(address,address,uint32,uint32) view returns (bytes)']);
const X = parseAbi(['function dstConfig(uint32) view returns (uint64 baseGas, uint16 multiplierBps, uint128 floorMarginUSD, uint128 nativeCap)']);
const ULN = [{ type: 'tuple', components: [{ name: 'confirmations', type: 'uint64' }, { name: 'requiredDVNCount', type: 'uint8' }, { name: 'optionalDVNCount', type: 'uint8' }, { name: 'optionalDVNThreshold', type: 'uint8' }, { name: 'requiredDVNs', type: 'address[]' }, { name: 'optionalDVNs', type: 'address[]' }] }];
const EXE = [{ type: 'tuple', components: [{ name: 'maxMessageSize', type: 'uint32' }, { name: 'executor', type: 'address' }] }];
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = {}; const Z = '0x0000000000000000000000000000000000000000';
  for (const [k, c] of Object.entries(MAIN)) { const pub = createPublicClient({ transport: http(c.rpc, { retryCount: 3 }) }); const r = (f, a) => pub.readContract({ address: c.endpoint, abi: E, functionName: f, args: a });
    const eid = await r('eid', []); out[k] = { eid: Number(eid), to: {} }; console.log(`${k} endpoint ${c.endpoint} eid ${eid} chainId ${await pub.getChainId()}`);
    for (const [k2, c2] of Object.entries(MAIN)) { if (k2 === k) continue;
      const sup = await r('isSupportedEid', [c2.eid]); if (!sup) { out[k].to[k2] = { supported: false }; console.log(`  -> ${k2}: NO PATHWAY`); continue; }
      const sl = await r('defaultSendLibrary', [c2.eid]); const [u] = decodeAbiParameters(ULN, await r('getConfig', [Z, sl, c2.eid, 2])); const [x] = decodeAbiParameters(EXE, await r('getConfig', [Z, sl, c2.eid, 1]));
      let cap = null; try { cap = (await pub.readContract({ address: x.executor, abi: X, functionName: 'dstConfig', args: [c2.eid] }))[3]; } catch {}
      out[k].to[k2] = { supported: true, confirmations: Number(u.confirmations), requiredDVNs: u.requiredDVNs.length, optionalDVNs: u.optionalDVNs.length, executor: x.executor, nativeCap: cap?.toString() };
      console.log(`  -> ${k2}: ok conf=${u.confirmations} reqDVN=${u.requiredDVNs.length} optDVN=${u.optionalDVNs.length} executor nativeCap=${cap == null ? '?' : Number(cap) / 1e18}`); } }
  fs.writeFileSync('/tmp/est/lz-mainnet.json', JSON.stringify(out, null, 1));
}
