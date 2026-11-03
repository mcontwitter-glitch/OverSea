// Balances of the connected wallet (any kind: extension, WalletConnect, or the X/Google thirdweb in-app wallet).
// Reads only wallet.address over MultiSea's read RPCs (Worker proxy, then public RPCs), never the wallet's provider,
// so it works the same for an embedded wallet that has no browser extension UI of its own.
import { formatUnits, type Hex } from 'viem';
import { readClient } from './wallet';
import { usdRates } from './shell';
import { chains, esc, logo } from './gx';
import { FW_CHAINS, NATIVE, TOKENS, chainBalances, chainUsd, rateOf, fmtUsd, type ChainBal } from './footkit';

const EXTRA = Object.keys(chains).filter(k => !(FW_CHAINS as readonly string[]).includes(k)); // e.g. Abstract: native only
const fmt = (v: bigint, d: number) => { const n = +formatUnits(v, d); return n === 0 ? '0' : n < 1e-4 ? '<0.0001' : n.toLocaleString(undefined, { maximumFractionDigits: 4 }); };
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
  let total = 0, priced = true; const rows: string[] = [];
  const row = (k: string, lines: string[], usd: number | null, ok: boolean) => rows.push(`<div class="wbrow" data-wbchain="${k}"><span class="wbch">${logo(k)} ${esc(chains[k].name)}</span><span class="wbv">${ok ? lines.join('') || '<span class="mut">0</span>' : '<span class="mut">couldn’t read</span>'}</span><span class="mut mono wbu">${usd ? fmtUsd(usd) : ''}</span></div>`);
  FW_CHAINS.forEach((k, i) => {
    const b: ChainBal = fw[i]; const lines: string[] = [];
    if (b.native) lines.push(`<b>${fmt(b.native, 18)} ${esc(NATIVE[k].symbol)}</b>`);
    TOKENS[k].forEach((t, j) => { const v = b.tokens[j]; if (v) lines.push(`<b>${fmt(v, t.decimals)} ${esc(t.symbol)}</b>`); });
    const u = chainUsd(k, b, r); if (u == null) { if (b.ok) priced = false; } else total += u; row(k, lines, u, b.ok);
  });
  EXTRA.forEach((k, i) => {
    const v = ex[i]; const sym = chains[k].native || 'ETH'; const px = (['ETH', 'APE', 'BNB'].includes(sym) ? sym : 'ETH') as 'ETH';
    const rt = rateOf(px, r); const u = v != null && rt != null ? +formatUnits(v, 18) * rt : null; if (u != null) total += u; else if (v) priced = false;
    row(k, v ? [`<b>${fmt(v, 18)} ${esc(sym)}</b>`] : [], u, v != null);
  });
  const html = `<div class="wbal"><div class="wbhd"><b>Balances</b><span class="mono">${priced ? fmtUsd(total) : '≈ ' + fmtUsd(total)}</span></div>${rows.join('')}
    <p class="mut small">Native + main tokens on every MultiSea chain. NFTs: <a href="/u/${esc(key)}">your profile</a> · <a href="/me">activity</a>.</p></div>`;
  cache.set(key, { at: Date.now(), html }); return html;
}
