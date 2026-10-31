// bitcoinjs-lib v6 needs a global Buffer in the browser. Imported first by src/btc/lib.ts.
import { Buffer } from 'buffer';
(globalThis as any).Buffer ??= Buffer;
