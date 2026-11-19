// Browser globals for Node-style dependencies (bitcoinjs-lib v6; the LayerZero Solana SDK's readable-stream v2 /
// process-nextick-args, which read the bare `process` global at load: "process is not defined" on Solana -> EVM).
// Imported first by every module that loads them (src/btc/lib.ts, src/solexist.ts, src/solui.ts, src/solsetup.ts, ...).
// `??=`: a real Node (tests, SSR) or another shim is left alone.
import { Buffer } from 'buffer';
const g = globalThis as any;
g.Buffer ??= Buffer;
g.global ??= g;
g.process ??= {
  browser: true, env: {}, version: '', versions: {}, argv: [], platform: 'browser', pid: 1,
  nextTick: (f: (...a: any[]) => void, ...a: any[]) => queueMicrotask(() => f(...a)),
  emitWarning: () => {}, cwd: () => '/', on: () => {}, stdout: null, stderr: null,
};
