// The LayerZero Solana SDK (and its stream / borsh deps) expect Node's `process` in the browser. Minimal shim, only loaded by
// /deploy-solana; imported before the SDK so it exists when those modules evaluate.
const g = globalThis as any;
g.process ??= { env: {}, version: '', versions: {}, browser: true, nextTick: (f: (...a: unknown[]) => void, ...a: unknown[]) => queueMicrotask(() => f(...a)) };
