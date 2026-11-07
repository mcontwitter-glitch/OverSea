import { api, getSession, signIn } from './auth';
import { API } from './wallet';
import { esc } from './gx';
import { addrHtml, hydrateNames, shortAddr } from './names';

type Message = { id: string; address: string; name: string; text: string; at: number };
type Page = { messages: Message[]; next: string | null; isAdmin: boolean; isOwner?: boolean; muted: boolean; address: string };

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
  let shell = ''; let sig = '';
  const NAMEKEY = `multisea-chatname-${slug}`;
  const SEND_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z"/></svg>';
  // The frame is built once per state; polling only repaints the message list, so typing is never interrupted.
  function draw() {
    const owner = !!page?.isOwner; const want = joined ? (owner ? 'owner' : 'joined') : auth() ? 'auth' : 'out';
    if (shell !== want || !root.querySelector('.holderchat')) {
      shell = want; sig = '';
      root.innerHTML = `<section class="holderchat" aria-label="${esc(title)} group chat"><div class="hchathead"><div class="hchatti"><b><span class="hchatlive"></span>Holder group chat</b><span class="mut small">Verified ${esc(title)} holders only</span></div>
        ${joined && owner ? `<button class="hchaticon" data-chat="rename" title="Display name" aria-label="Set display name">✎</button>` : ''}<button class="hchaticon" data-chat="refresh" title="Refresh messages" aria-label="Refresh messages">↻</button></div>
        ${joined && owner ? `<div class="hchatname" data-chat="namebox" hidden><input data-chat="name" maxlength="32" autocomplete="nickname" placeholder="Display name (optional)" aria-label="Display name" value="${esc(localStorage.getItem(NAMEKEY) || '')}"></div>` : ''}
        <p class="err small" data-chat="error" hidden></p><div class="hchatmsgs" data-chat="messages" aria-live="polite"></div>
        ${!joined && !auth() ? '<div class="hchatjoin"><p class="mut">Sign with your wallet to join the conversation. No gas or transaction.</p><button class="bbtn" data-chat="join">Sign to join</button></div>' : ''}
        ${joined ? `<form class="hchatform" data-chat="form"><div class="hchatbar"><textarea data-chat="text" rows="1" maxlength="500" placeholder="Start a message" aria-label="Message"></textarea><button type="submit" class="hchatgo" aria-label="Send">${SEND_SVG}</button></div></form>` : ''}</section>`;
    }
    paintMessages(page?.messages || []);
  }
  const initial = (m: Message) => (m.name || m.address.slice(2)).trim().charAt(0).toUpperCase() || '?';
  const hue = (a: string) => parseInt(a.slice(2, 8), 16) % 360;
  function paintMessages(items: Message[], prepend = false) {
    const list = root.querySelector<HTMLElement>('[data-chat=messages]'); if (!list) return;
    if (!prepend) { const s2 = items.map(m => m.id).join() + '|' + (page?.next || '') + (page?.isAdmin ? 1 : 0); if (s2 === sig) return; sig = s2; }
    if (!items.length && !prepend) { list.innerHTML = '<div class="hchatempty"><b>No messages yet</b><p>Be the first holder to say hello.</p></div>'; return; }
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const frag = document.createDocumentFragment();
    if (!prepend && page?.next) { const o = document.createElement('button'); o.className = 'hchatolder'; o.dataset.chat = 'older'; o.textContent = 'Load earlier messages'; frag.append(o); }
    items.forEach(m => {
      const mine = m.address === page?.address;
      const row = document.createElement('article'); row.className = 'hchatmsg' + (mine ? ' mine' : '');
      if (!mine) { const av = document.createElement('div'); av.className = 'hchatav'; av.style.background = `hsl(${hue(m.address)} 55% 38%)`; av.textContent = initial(m); row.append(av); }
      const col = document.createElement('div'); col.className = 'hchatcol';
      if (!mine) { const who = document.createElement('span'); who.className = 'hchatauthor'; if (m.name) who.textContent = m.name; else who.innerHTML = addrHtml(m.address); col.append(who); }
      const body = document.createElement('p'); body.className = 'hchattext'; body.textContent = m.text;
      const meta = document.createElement('div'); meta.className = 'hchatmeta';
      const time = document.createElement('time'); time.dateTime = new Date(m.at).toISOString(); time.textContent = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      meta.append(time);
      if (page?.isAdmin) { const del = document.createElement('button'); del.className = 'hchatdelete'; del.dataset.delete = m.id; del.textContent = 'Delete'; del.title = `Delete message from ${m.address}`; meta.append(del); }
      col.append(body, meta); row.append(col); frag.append(row);
    });
    if (prepend) { const h = list.scrollHeight; list.querySelector('.hchatolder')?.after(frag); list.scrollTop += list.scrollHeight - h; }
    else { list.replaceChildren(frag); if (atBottom || !older) list.scrollTop = list.scrollHeight; }
    hydrateNames(list);
  }
  root.addEventListener('click', async e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-chat],[data-delete]'); if (!b) return;
    try {
      if (b.dataset.chat === 'join') { b.textContent = 'Check your wallet…'; await signIn(`Join the ${title} holder group chat on MultiSea.`, [`multisea:holders:${slug}`]); await load(); }
      if (b.dataset.chat === 'refresh') { sig = ''; await load(); }
      if (b.dataset.chat === 'rename') { const nb = root.querySelector<HTMLElement>('[data-chat=namebox]')!; nb.hidden = !nb.hidden; if (!nb.hidden) nb.querySelector('input')!.focus(); }
      if (b.dataset.chat === 'older' && page?.next) {
        b.textContent = 'Loading…'; const old = await api(`/holders/${encodeURIComponent(slug)}/messages?before=${encodeURIComponent(page.next)}`, { auth: true });
        older = true; page.next = old.next; paintMessages(old.messages, true); b.hidden = !page.next; b.textContent = 'Load earlier messages';
      }
      if (b.dataset.delete && confirm('Delete this holder chat message?')) { await api(`/holders/${encodeURIComponent(slug)}/messages/${encodeURIComponent(b.dataset.delete)}/delete`, { method: 'POST', auth: true }); sig = ''; await load(); }
    } catch (err) { drawErr(err); if (!joined) draw(); }
  });
  const grow = (t: HTMLTextAreaElement) => { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; };
  root.addEventListener('input', e => {
    const t = e.target as HTMLElement;
    if (t.getAttribute('data-chat') === 'text') grow(t as HTMLTextAreaElement);
    if (t.getAttribute('data-chat') === 'name') localStorage.setItem(NAMEKEY, (t as HTMLInputElement).value);
  });
  root.addEventListener('keydown', e => {
    const t = e.target as HTMLElement;
    if (t.getAttribute('data-chat') === 'text' && e.key === 'Enter' && !e.shiftKey && !(e as KeyboardEvent).isComposing && !/Android|iPhone|iPad/i.test(navigator.userAgent)) { e.preventDefault(); (t.closest('form') as HTMLFormElement).requestSubmit(); }
  });
  root.addEventListener('submit', async e => {
    if (!(e.target as HTMLElement).matches('[data-chat=form]')) return; e.preventDefault(); if (busy) return;
    const text = root.querySelector<HTMLTextAreaElement>('[data-chat=text]')!;
    if (!text.value.trim()) return; busy = true;
    const send = (e.target as HTMLElement).querySelector<HTMLButtonElement>('button[type=submit]')!; send.disabled = true;
    try { await api(`/holders/${encodeURIComponent(slug)}/messages`, { auth: true, body: { text: text.value, name: page?.isOwner ? localStorage.getItem(NAMEKEY) || '' : '' } }); text.value = ''; grow(text); busy = false; older = false; await load(); text.focus(); }
    catch (err) { drawErr(err); } finally { busy = false; send.disabled = false; }
  });
  draw(); if (auth()) load();
}

export function shortMessageAddress(a: string) { return shortAddr(a); }
export { API };
