import { log } from "../log.js";

export type Utxo = { txid: string; vout: number; value: bigint; confirmed: boolean };
export type TxInfo = { confirmations: number; hex: string } | null;

export interface BtcBackend {
  utxos(address: string): Promise<Utxo[]>;
  broadcast(hex: string): Promise<string>;
  tx(txid: string): Promise<TxInfo>;
  feeRate(): Promise<number>; // sat/vB
  /** One-time setup (e.g. import watch-only address). */
  init?(serviceAddress: string): Promise<void>;
}

async function httpJson(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

/** Esplora / mempool.space REST API (signet/testnet/mainnet, or a local electrs/esplora on regtest). */
export class EsploraBackend implements BtcBackend {
  constructor(private base: string, private feeApi: string, private fallback: number) {}
  async utxos(a: string): Promise<Utxo[]> {
    const r = await httpJson(`${this.base}/address/${a}/utxo`);
    return r.map((u: any) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: !!u.status?.confirmed }));
  }
  async broadcast(hex: string) {
    const r = await fetch(`${this.base}/tx`, { method: "POST", body: hex });
    const t = await r.text();
    if (!r.ok) throw new Error(`broadcast failed: ${t.slice(0, 300)}`);
    return t.trim();
  }
  async tx(txid: string): Promise<TxInfo> {
    const r = await fetch(`${this.base}/tx/${txid}/status`);
    if (r.status === 404 || r.status === 400) return null;
    const st = await r.json();
    const hex = await (await fetch(`${this.base}/tx/${txid}/hex`)).text();
    if (!st.confirmed) return { confirmations: 0, hex };
    const tip = Number(await (await fetch(`${this.base}/blocks/tip/height`)).text());
    return { confirmations: tip - st.block_height + 1, hex };
  }
  async feeRate() {
    try {
      if (this.feeApi) { const f = await httpJson(this.feeApi); return Number(f.halfHourFee ?? f.fastestFee); }
      const e = await httpJson(`${this.base}/fee-estimates`); if (e["3"]) return Math.ceil(e["3"]);
    } catch (e) { log.warn("fee api failed, using fallback", { err: e }); }
    return this.fallback;
  }
}

/** bitcoind JSON-RPC (regtest / own node). Requires -txindex=1 for tx() of arbitrary txids.
 *  UTXOs come from a WATCH-ONLY descriptor wallet holding only the service address (no keys in bitcoind). */
export class BitcoindRpcBackend implements BtcBackend {
  private id = 0;
  constructor(private url: string, private user: string, private pass: string, private wallet: string, private fallback: number) {}
  async call(method: string, params: unknown[] = [], wallet = false): Promise<any> {
    const url = wallet ? `${this.url}/wallet/${this.wallet}` : this.url;
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${this.user}:${this.pass}`).toString("base64") },
      body: JSON.stringify({ jsonrpc: "1.0", id: ++this.id, method, params }),
    });
    const j: any = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
    return j.result;
  }
  async init(address: string) {
    const wallets: string[] = await this.call("listwallets");
    if (!wallets.includes(this.wallet)) {
      try { await this.call("loadwallet", [this.wallet]); }
      catch { await this.call("createwallet", [this.wallet, true, true, "", false, true]); } // disable_private_keys, blank, descriptors
    }
    const { descriptor } = await this.call("getdescriptorinfo", [`addr(${address})`]);
    await this.call("importdescriptors", [[{ desc: descriptor, timestamp: 0 }]], true);
  }
  async utxos(a: string): Promise<Utxo[]> {
    const r = await this.call("listunspent", [0, 9999999, [a]], true);
    return r.map((u: any) => ({ txid: u.txid, vout: u.vout, value: BigInt(Math.round(u.amount * 1e8)), confirmed: u.confirmations > 0 }));
  }
  broadcast(hex: string) { return this.call("sendrawtransaction", [hex]); }
  async tx(txid: string): Promise<TxInfo> {
    try { const t = await this.call("getrawtransaction", [txid, true]); return { confirmations: t.confirmations ?? 0, hex: t.hex }; }
    catch (e: any) { if (/No such mempool|not found/i.test(e.message)) return null; throw e; }
  }
  async feeRate() {
    try { const r = await this.call("estimatesmartfee", [3]); if (r.feerate) return Math.ceil((r.feerate * 1e8) / 1000); } catch {}
    return this.fallback;
  }
}
