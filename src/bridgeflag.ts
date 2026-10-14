// Feature flag for the Bridge UI. Enabled only when /bridge.json lists real (non-fork) deployments,
// or on a local/tunnel preview host. Kept tiny so the main bundle never pulls in the bridge code.
let p: Promise<boolean> | null = null;
const previewHost = () => /^(localhost|127\.0\.0\.1)$|\.trycloudflare\.com$/.test(location.hostname);
export function bridgeEnabled(): Promise<boolean> {
  return (p ??= fetch('/bridge.json', { cache: 'no-cache' })
    .then(r => (r.ok && (r.headers.get('content-type') || '').includes('json') ? r.json() : null))
    .then((c: any) => !!c && Array.isArray(c.collections) && c.collections.length > 0 && (c.mode !== 'fork' || previewHost()))
    .catch(() => false));
}
/** Reveal any [data-bridge-flag] elements once the flag resolves true. */
export function applyBridgeFlag(root: ParentNode = document) {
  bridgeEnabled().then(on => { if (on) root.querySelectorAll<HTMLElement>('[data-bridge-flag]').forEach(e => { e.hidden = false; }); });
}
