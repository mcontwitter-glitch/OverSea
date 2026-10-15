// Pure helpers for cross-chain checkout via Relay (no DOM / wallet). Used by xpay.ts and the fork/quote tests.
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
export const RELAY = 'https://api.relay.link';
export const FEE_WALLET = '0x25411039F77529A543344603bD8acdd65fABA4d0';
export const FLAT_FEE_USD = 0.3;
export const ZERO = '0x0000000000000000000000000000000000000000';
const SEAPORT_ABI = parseAbi(['function fulfillAdvancedOrder(((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData),(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[],bytes32,address) payable returns (bool)']);

/** One-step (pay + buy in Relay's destination call) is only safe for open orders: restricted (SignedZone) orders bind the zone signature to msg.sender, which would be Relay's Multicaller, not the buyer. */
export const oneStepOk = (p: any) => p && p.zone.toLowerCase() === ZERO && (Number(p.orderType) === 0 || Number(p.orderType) === 1);

/** fulfillAdvancedOrder with an explicit recipient, so the NFT goes to the buyer even though Relay's Multicaller is msg.sender. */
export function advancedFulfillCalldata(order: { parameters: any; signature: string }, recipient: string): { data: Hex; value: bigint } {
  const p = order.parameters; const n = (x: any) => BigInt(x);
  const parameters = {
    offerer: p.offerer, zone: p.zone, orderType: Number(p.orderType), startTime: n(p.startTime), endTime: n(p.endTime), zoneHash: p.zoneHash, salt: n(p.salt), conduitKey: p.conduitKey,
    totalOriginalConsiderationItems: n(p.totalOriginalConsiderationItems ?? p.consideration.length),
    offer: p.offer.map((o: any) => ({ itemType: Number(o.itemType), token: o.token, identifierOrCriteria: n(o.identifierOrCriteria), startAmount: n(o.startAmount), endAmount: n(o.endAmount) })),
    consideration: p.consideration.map((c: any) => ({ itemType: Number(c.itemType), token: c.token, identifierOrCriteria: n(c.identifierOrCriteria), startAmount: n(c.startAmount), endAmount: n(c.endAmount), recipient: c.recipient })),
  };
  if (parameters.consideration.some((c: any) => c.itemType !== 0 || c.startAmount !== c.endAmount)) throw new Error('Only fixed-price native-currency listings can be bought cross-chain in one step');
  const value = parameters.consideration.reduce((s: bigint, c: any) => s + c.startAmount, 0n);
  const data = encodeFunctionData({ abi: SEAPORT_ABI, functionName: 'fulfillAdvancedOrder', args: [{ parameters, numerator: 1n, denominator: 1n, signature: order.signature as Hex, extraData: '0x' }, [], ('0x' + '0'.repeat(64)) as Hex, recipient as Hex] });
  return { data, value };
}

export type QuoteReq = { user: string; originChainId: number; destinationChainId: number; amount: bigint; destinationCurrency?: string; txs?: { to: string; value: string; data: string }[]; feeBps?: string };
export async function relayQuote(q: QuoteReq, f: typeof fetch = fetch) {
  const body: any = { user: q.user, recipient: q.user, refundTo: q.user, originChainId: q.originChainId, destinationChainId: q.destinationChainId, originCurrency: ZERO, destinationCurrency: q.destinationCurrency || ZERO, amount: q.amount.toString(), tradeType: 'EXACT_OUTPUT' };
  if (q.txs) body.txs = q.txs;
  if (q.feeBps && +q.feeBps > 0) body.appFees = [{ recipient: FEE_WALLET, fee: q.feeBps }];
  const r = await f(`${RELAY}/quote/v2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `Relay quote failed (${r.status})`), { kind: 'stale', code: j.errorCode });
  return j;
}
/** Two quotes: an indicative one to learn the USD size, then the real one with an app fee (in bps of input) worth $0.30. */
export async function quoteWithFlatFee(q: QuoteReq, f: typeof fetch = fetch) {
  const first = await relayQuote(q, f);
  const inUsd = Number(first.details?.currencyIn?.amountUsd || 0);
  const feeBps = inUsd > 0 ? (Math.ceil((FLAT_FEE_USD / inUsd) * 10000 * 100) / 100).toFixed(2) : '0';
  const quote = await relayQuote({ ...q, feeBps }, f);
  return { quote, feeBps };
}
const num = (x: any) => Number(x || 0);
/** Summary numbers in the source chain's native token (wei) and USD. */
export function summarize(quote: any) {
  const inC = quote.details?.currencyIn; const fees = quote.fees || {};
  const deposit = quote.steps?.flatMap((s: any) => s.items || []).reduce((a: bigint, i: any) => a + BigInt(i.data?.value || 0), 0n) ?? 0n;
  const usdPerWei = num(inC?.amountUsd) / Math.max(1, num(inC?.amount)); // source native USD per wei
  const toWei = (usd: number) => (usdPerWei > 0 ? BigInt(Math.round(usd / usdPerWei)) : 0n);
  const feeUsd = num(fees.relayer?.amountUsd) + num(fees.app?.amountUsd);
  const gasWei = BigInt(fees.gas?.currency?.chainId === inC?.currency?.chainId ? fees.gas?.amount || 0 : 0);
  const gasUsd = num(fees.gas?.amountUsd);
  return { deposit, depositUsd: num(inC?.amountUsd), feeUsd, feeWei: toWei(feeUsd), gasWei, gasUsd, totalWei: deposit + gasWei, totalUsd: num(inC?.amountUsd) + gasUsd, appFeeUsd: num(fees.app?.amountUsd), relayerUsd: num(fees.relayer?.amountUsd), timeSec: quote.details?.timeEstimate };
}
