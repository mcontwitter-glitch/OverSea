// Encodes a sweep (fulfillAvailableOrders) of a single listing + a same-chain bundle and decodes it back.
// Run: node scripts/test-seaport-batch.mjs
import { execSync } from 'node:child_process'; import fs from 'node:fs';
execSync('worker/node_modules/.bin/esbuild src/seaorder.ts --bundle --format=esm --platform=node --outfile=scripts/.tmp-seaorder.mjs --log-level=error');
try {
  const { buildBundleOrder, fulfillAvailableCalldata, buildListing } = await import('./.tmp-seaorder.mjs');
  const { decodeFunctionData, parseAbi } = await import('viem');
  const fees = [{ recipient: '0x25411039F77529A543344603bD8acdd65fABA4d0', bps: 50, required: true, kind: 'multisea', ceil: true }];
  const a = buildListing({ offerer: '0x' + '11'.repeat(20), token: '0x' + '22'.repeat(20), id: 5, priceWei: 10n ** 17n, fees, conduitKey: '0x' + '0'.repeat(64), counter: 0n, duration: 86400, salt: 1n });
  const b = buildBundleOrder({ offerer: '0x' + '11'.repeat(20), items: [{ token: '0x' + '22'.repeat(20), id: 6 }, { token: '0x' + '33'.repeat(20), id: 7 }], priceWei: 3n * 10n ** 17n, fees, counter: 0n, duration: 86400, salt: 2n });
  if (b.offer.length !== 2 || b.consideration[1].startAmount !== String(3n * 10n ** 17n * 50n / 10000n)) throw new Error('bundle order shape');
  const { data, value } = fulfillAvailableCalldata([{ parameters: a, signature: '0x' + 'ab'.repeat(65) }, { parameters: b, signature: '0x' + 'cd'.repeat(65) }]);
  const T = '(address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems)';
  const d = decodeFunctionData({ abi: parseAbi([`function fulfillAvailableOrders((${T} parameters,bytes signature)[],(uint256,uint256)[][],(uint256,uint256)[][],bytes32,uint256)`]), data });
  const ok = data.slice(0, 10) === '0xed98a574' && value === 4n * 10n ** 17n && d.args[0].length === 2 && d.args[1].length === 3 && d.args[2].length === 4 && d.args[4] === 2n;
  console.log(ok ? 'OK fulfillAvailableOrders sweep + bundle encoding' : 'FAIL'); if (!ok) process.exit(1);
} finally { fs.rmSync('scripts/.tmp-seaorder.mjs', { force: true }); }
