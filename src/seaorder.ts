// Pure Seaport 1.6 listing builder (no DOM, no wallet) — shared by sell.ts and the fork test.
export const ZERO = '0x0000000000000000000000000000000000000000' as const;
export const ZERO32 = ('0x' + '0'.repeat(64)) as `0x${string}`;
export type Fee = { recipient: string; bps: number; required: boolean; kind: 'opensea' | 'creator' };
export type Item = { itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string };
export type Cons = Item & { recipient: string };
export type OrderParams = { offerer: string; zone: string; offer: Item[]; consideration: Cons[]; orderType: number; startTime: string; endTime: string; zoneHash: string; salt: string; conduitKey: string; totalOriginalConsiderationItems: number; counter: string };

export const EXPIRY = { '1d': 86400, '7d': 7 * 86400, '30d': 30 * 86400 } as const;

/** Split a total price (wei) into seller + fee consideration items. */
export function splitPrice(priceWei: bigint, fees: Fee[]) {
  const parts = fees.map(f => ({ ...f, amount: (priceWei * BigInt(f.bps)) / 10000n }));
  const seller = priceWei - parts.reduce((a, p) => a + p.amount, 0n);
  return { seller, parts };
}

export function buildListing(a: { offerer: string; token: string; id: number | string; priceWei: bigint; fees: Fee[]; conduitKey: string; zone?: string; counter: bigint | string; now?: number; duration: number; salt?: bigint }): OrderParams {
  if (a.priceWei <= 0n) throw new Error('Price must be greater than 0');
  const { seller, parts } = splitPrice(a.priceWei, a.fees.filter(f => f.bps > 0));
  if (seller <= 0n) throw new Error('Fees exceed price');
  const now = a.now ?? Math.floor(Date.now() / 1000);
  const zone = a.zone && a.zone.toLowerCase() !== ZERO ? a.zone.toLowerCase() : ZERO;
  const nat = (amt: bigint, recipient: string): Cons => ({ itemType: 0, token: ZERO, identifierOrCriteria: '0', startAmount: amt.toString(), endAmount: amt.toString(), recipient: recipient.toLowerCase() });
  const consideration = [nat(seller, a.offerer.toLowerCase()), ...parts.filter(p => p.amount > 0n).map(p => nat(p.amount, p.recipient))];
  const salt = a.salt ?? BigInt('0x' + [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join(''));
  return {
    offerer: a.offerer.toLowerCase(), zone,
    offer: [{ itemType: 2, token: a.token.toLowerCase(), identifierOrCriteria: String(a.id), startAmount: '1', endAmount: '1' }],
    consideration,
    orderType: zone === ZERO ? 0 : 2, // FULL_OPEN, or FULL_RESTRICTED with OpenSea SignedZone (enables offchain cancel)
    startTime: String(now - 60), endTime: String(now + a.duration),
    zoneHash: ZERO32, salt: salt.toString(), conduitKey: a.conduitKey,
    totalOriginalConsiderationItems: consideration.length, counter: String(a.counter),
  };
}

export const ORDER_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' }, { name: 'zone', type: 'address' }, { name: 'offer', type: 'OfferItem[]' }, { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' }, { name: 'startTime', type: 'uint256' }, { name: 'endTime', type: 'uint256' }, { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' }, { name: 'conduitKey', type: 'bytes32' }, { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [{ name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifierOrCriteria', type: 'uint256' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }],
  ConsiderationItem: [{ name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifierOrCriteria', type: 'uint256' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }, { name: 'recipient', type: 'address' }],
} as const;

const lc = (a: string) => a.toLowerCase();
export const domain = (chainId: number, seaport: string) => ({ name: 'Seaport', version: '1.6', chainId, verifyingContract: lc(seaport) as `0x${string}` });

/** EIP-712 payload for signTypedData (counter included, totalOriginalConsiderationItems excluded). */
export function orderTypedData(chainId: number, seaport: string, o: OrderParams) {
  const { totalOriginalConsiderationItems, ...m } = o; void totalOriginalConsiderationItems;
  // Lowercase addresses: viem rejects mixed-case addresses with a bad checksum (e.g. OpenSea's SignedZone vanity address).
  m.offerer = lc(m.offerer); m.zone = lc(m.zone);
  m.offer = m.offer.map(x => ({ ...x, token: lc(x.token) })); m.consideration = m.consideration.map(x => ({ ...x, token: lc(x.token), recipient: lc(x.recipient) }));
  return { domain: domain(chainId, seaport), types: ORDER_TYPES, primaryType: 'OrderComponents' as const, message: m as any };
}
/** EIP-712 payload for OpenSea's offchain cancel. */
export function cancelTypedData(chainId: number, seaport: string, orderHash: string) {
  return { domain: domain(chainId, seaport), types: { OrderHash: [{ name: 'orderHash', type: 'bytes32' }] } as const, primaryType: 'OrderHash' as const, message: { orderHash: orderHash as `0x${string}` } };
}
