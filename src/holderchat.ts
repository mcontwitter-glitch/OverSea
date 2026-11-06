import { api, getSession, signIn } from './auth';
import { API } from './wallet';
import { esc } from './gx';
import { addrHtml, hydrateNames, shortAddr } from './names';

type Message = { id: string; address: string; name: string; text: string; at: number };
type Page = { messages: Message[]; next: string | null; isAdmin: boolean; muted: boolean; address: string };

/** SIWE authorizes reads and writes; this UI deliberately renders every message as text, never HTML. */
export function mountHolderChat(root: HTMLElement, slug: string, title: string) {
  let timer = 0, busy = false, page: Page | null = null, older = false, joined = false;
  const auth = () => !!getSession();
  function stop() { clearInterval(timer); timer = 0; }
  function start() { if (!timer) timer = window.setInterval(() => { if (!document.hidden && joined) load().catch(() => {}); }, 4000); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && joined) load().catch(() => {}); });
  async function load() {
    if (busy) return; busy = true;
    try { page = await api(`/holders/${encodeURIComponent(slug)}/messages`, { auth: true }); joined = true; draw(); start(); }
    catch (e: any) { if (e?.message?.includes('sign in')) { joined = false; stop(); draw(); } drawErr(e); }
    finally { busy = false; }
  }
  function drawErr(e: any) {
    const b = root.querySelector<HTMLElement>('[data-chat=error]'); if (b) { b.textContent = e?.message || 'Chat unavailable'; b.hidden = false; }
  }
  function draw() {
    root.innerHTML = `<section class="holderchat" aria-label="${esc(title)} group chat"><div class="hchathead"><div><span class="hchatlive"></span><b>Holder group chat</b><p class="mut small">Only verified ${esc(title)} holders can read and post.</p></div><button class="hchatrefresh" data-chat="refresh" title="Refresh messages" aria-label="Refresh messages">↻</button></div>
      <p class="err small" data-chat="error" hidden></p><div class="hchatmsgs" data-chat="messages" aria-live="polite"></div>
      ${!joined && !auth() ? '<div class="hchatjoin"><p class="mut">Sign with your wallet to join the conversation. No gas or transaction.</p><button class="bbtn" data-chat="join">Sign to join</button></div>' : ''}
      ${joined ? `${page?.next ? '<button class="hchatolder" data-chat="older">Load earlier messages</button>' : ''}<form class="hchatform" data-chat="form"><input data-chat="name" maxlength="32" autocomplete="nickname" placeholder="Display name (optional)" aria-label="Display name"><div class="hchatsend"><textarea data-chat="text" rows="2" maxlength="500" placeholder="Say something to the group…" aria-label="Chat message" ${page?.muted ? 'disabled' : ''}></textarea><button class="bbtn" type="submit" ${page?.muted ? 'disabled' : ''}>Send</button></div><div class="hchatfoot"><span data-chat="count">0 / 500</span><span class="mut">${page?.muted ? 'You are muted' : 'Auto-refreshes every 4 seconds'}</span></div></form>` : ''}</section>`;
    paintMessages(page?.messages || []);
  }
  function paintMessages(items: Message[], prepend = false) {
    const list = root.querySelector<HTMLElement>('[data-chat=messages]'); if (!list) return;
    if (!items.length && !prepend) { list.innerHTML = '<div class="hchatempty"><b>No messages yet</b><p>Be the first holder to say hello.</p></div>'; return; }
    const frag = document.createDocumentFragment();
    items.forEach(m => {
      const row = document.createElement('article'); row.className = 'hchatmsg' + (m.address === page?.address ? ' mine' : '');
      const meta = document.createElement('div'); meta.className = 'hchatmeta';
      const who = document.createElement('span'); who.className = 'hchatauthor';
      if (m.name) who.textContent = m.name; else who.innerHTML = addrHtml(m.address);
      const time = document.createElement('time'); time.dateTime = new Date(m.at).toISOString(); time.textContent = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      meta.append(who, time);
      if (page?.isAdmin) { const del = document.createElement('button'); del.className = 'hchatdelete'; del.dataset.delete = m.id; del.textContent = 'Delete'; del.title = `Delete message from ${m.address}`; meta.append(del); }
      const body = document.createElement('p'); body.className = 'hchattext'; body.textContent = m.text;
      row.append(meta, body); frag.append(row);
    });
    if (prepend) list.prepend(frag); else { list.replaceChildren(frag); list.scrollTop = list.scrollHeight; }
    hydrateNames(list);
  }
  root.addEventListener('click', async e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-chat],[data-delete]'); if (!b) return;
    try {
      if (b.dataset.chat === 'join') { b.textContent = 'Check your wallet…'; await signIn(`Join the ${title} holder group chat on MultiSea.`, [`multisea:holders:${slug}`]); await load(); }
      if (b.dataset.chat === 'refresh') await load();
      if (b.dataset.chat === 'older' && page?.next) {
        b.textContent = 'Loading…'; const old = await api(`/holders/${encodeURIComponent(slug)}/messages?before=${encodeURIComponent(page.next)}`, { auth: true });
        older = true; paintMessages(old.messages, true); page.next = old.next; b.hidden = !page.next; b.textContent = 'Load earlier messages';
      }
      if (b.dataset.delete && confirm('Delete this holder chat message?')) { await api(`/holders/${encodeURIComponent(slug)}/messages/${encodeURIComponent(b.dataset.delete)}/delete`, { method: 'POST', auth: true }); await load(); }
    } catch (err) { drawErr(err); if (!joined) draw(); }
  });
  root.addEventListener('input', e => {
    if ((e.target as HTMLElement).getAttribute('data-chat') === 'text') {
      const n = (e.target as HTMLTextAreaElement).value.length; const count = root.querySelector('[data-chat=count]'); if (count) count.textContent = `${n} / 500`;
    }
  });
  root.addEventListener('submit', async e => {
    if (!(e.target as HTMLElement).matches('[data-chat=form]')) return; e.preventDefault(); if (busy) return;
    const text = root.querySelector<HTMLTextAreaElement>('[data-chat=text]')!; const name = root.querySelector<HTMLInputElement>('[data-chat=name]')!;
    if (!text.value.trim()) return; busy = true;
    const send = (e.target as HTMLElement).querySelector<HTMLButtonElement>('button[type=submit]')!; send.disabled = true;
    try { await api(`/holders/${encodeURIComponent(slug)}/messages`, { auth: true, body: { text: text.value, name: name.value } }); text.value = ''; busy = false; await load(); }
    catch (err) { drawErr(err); } finally { busy = false; send.disabled = false; }
  });
  draw(); if (auth()) load();
}

export function shortMessageAddress(a: string) { return shortAddr(a); }
export { API };
