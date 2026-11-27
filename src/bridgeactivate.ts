// Founder notice for a collection whose bridge is off until the creator allows the escrow on its transfer list.
// Driven by /bridge.json `bridgeActivate[slug]`; delete that entry (and bridgeDisabled) to take the notice down.
import { esc } from './shell';
import { cfgJson } from './bridgeflag';

export type BridgeActivate = {
  name?: string; owner: string; escrow: string; validator: string;
  listId: number; listType?: number; chain?: string; ruleset?: string;
  toolUrl: string; toolLabel?: string;
};

export function bridgeActivateFor(slug: string): Promise<BridgeActivate | null> {
  return cfgJson().then((c: any) => {
    const n = slug && c?.bridgeActivate?.[slug];
    if (!n || !n.owner || !n.escrow || !n.validator || !n.listId || !n.toolUrl) return null;
    return n as BridgeActivate;
  });
}

const row = (label: string, addr: string) =>
  `<div class="ba-addr"><span class="mut small">${esc(label)}</span><span class="mono" title="${esc(addr)}">${esc(addr)}</span><button type="button" class="obtn sm" data-copy="${esc(addr)}">Copy</button></div>`;

export function bridgeActivateHtml(n: BridgeActivate): string {
  const name = n.name || 'This collection';
  const list = String(n.listId);
  const typ = n.listType ?? 1;
  const rules = n.ruleset || 'Whitelist';
  const chain = n.chain === 'robinhood' ? 'Robinhood' : (n.chain || 'the collection\'s chain');
  const tool = n.toolLabel || 'Transfer Lists';
  return `<div class="fcard ba-note" data-bridge-activate>
    <h4>To activate the Bridge</h4>
    <p>Bridging is off so ${esc(name)} can't get stuck in the escrow. ${esc(name)} uses Limit Break's creator transfer rules (${esc(rules)} ruleset, list ${esc(list)}) with smart-wallet transfers turned off. The MultiSea escrow is a contract, so it can't send ${esc(name)} back to holders.</p>
    <p>The owner of list ${esc(list)} — the wallet below — opens <a href="${esc(n.toolUrl)}" target="_blank" rel="noopener">${esc(tool)}</a> on developers.apptokens.com, connects, and adds the MultiSea escrow to list ${esc(list)}'s whitelist. Or call <span class="mono">addAccountsToList(${esc(list)}, ${typ}, [escrow])</span> on the validator, on ${esc(chain)}.</p>
    ${row('List owner', n.owner)}${row('Escrow', n.escrow)}${row('Validator', n.validator)}
    <p class="mut small">This does not give MultiSea any admin role or control over the collection, and it does not change royalties. It only lets the escrow move ${esc(name)} for bridging. After it's done, MultiSea will turn the Bridge tab back on.</p>
  </div>`;
}

/** Delegated copy handler. Safe to call once per root. */
export function bindBridgeActivateCopy(root: ParentNode) {
  root.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]');
    if (!b?.dataset.copy || !b.closest('[data-bridge-activate]')) return;
    e.preventDefault();
    const prev = b.textContent;
    navigator.clipboard?.writeText(b.dataset.copy).then(() => {
      b.textContent = 'Copied'; setTimeout(() => { b.textContent = prev || 'Copy'; }, 1500);
    }).catch(() => {});
  });
}
