// Balances of the connected wallet (any kind: extension, WalletConnect, or the X/Google thirdweb in-app wallet).
// Reads only wallet.address over MultiSea's read RPCs (Worker proxy, then public RPCs), never the wallet's provider,
// so it works the same for an embedded wallet that has no browser extension UI of its own.
import { formatUnits, type Hex } from 'viem';
import { readClient } from './wallet';
import { usdRates } from './shell';
import { chains, esc } from './gx';
import { FW_CHAINS, TOKENS, chainBalances, chainUsd, rateOf, fmtUsd } from './footkit';

const EXTRA = Object.keys(chains).filter(k => !(FW_CHAINS as readonly string[]).includes(k)); // e.g. Abstract: native only
const cache = new Map<string, { at: number; html: string }>();

export async function balancesHtml(addr: string, fresh = false): Promise<string> {
  const key = addr.toLowerCase(); const c = cache.get(key);
  if (!fresh && c && Date.now() - c.at < 60_000) return c.html;
  const a = addr as Hex;
  const [fw, ex, r] = await Promise.all([
    Promise.all(FW_CHAINS.map(k => chainBalances(k, [a]).then(x => x[0]))),
    Promise.all(EXTRA.map(k => readClient(k).getBalance({ address: a }).then((v: bigint) => v).catch(() => null))),
    usdRates().catch(() => ({ ETH: null, APE: null, BNB: null })),
  ]);
  let total = 0, priced = true;
  FW_CHAINS.forEach((k, i) => {
    const b = fw[i], u = chainUsd(k, b, r);
    if (u == null || b.tokens.some(v => v == null) || TOKENS[k].some((t, j) => b.tokens[j] && rateOf(t.px, r) == null)) priced = false;
    if (u != null) total += u;
  });
  EXTRA.forEach((k, i) => {
    const v = ex[i], sym = chains[k].native || 'ETH';
    const px = (['ETH', 'APE', 'BNB'].includes(sym) ? sym : 'ETH') as 'ETH';
    const rt = rateOf(px, r), u = v != null && (v === 0n || rt != null) ? +formatUnits(v, 18) * (rt || 0) : null;
    if (u != null) total += u; else priced = false;
  });
  const html = `<a class="wbal wbsummary" href="/u/${esc(key)}"><div class="wbhd"><b>Balance</b><span class="mono">${priced ? fmtUsd(total) : '≈ ' + fmtUsd(total)}</span></div></a>`;
  cache.set(key, { at: Date.now(), html }); return html;
}
