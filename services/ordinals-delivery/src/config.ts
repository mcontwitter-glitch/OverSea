import { readFileSync, existsSync } from "node:fs";
import type { BtcNetworkName } from "./btc/networks.js";

/** Load KEY=VALUE lines from a .env file (no dependency). Existing env wins. */
export function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
const num = (name: string, d: number) => (process.env[name] ? Number(process.env[name]) : d);

/** Secret from env var NAME or from file at NAME_FILE (preferred). Never logged. */
export function secret(name: string, optional = false): string | undefined {
  const f = process.env[`${name}_FILE`];
  if (f) return readFileSync(f, "utf8").trim();
  const v = process.env[name];
  if (!v && !optional) throw new Error(`missing secret ${name} (or ${name}_FILE)`);
  return v?.trim();
}

export type Config = ReturnType<typeof loadConfig>;
export function loadConfig() {
  const btcNetwork = (process.env.BTC_NETWORK ?? "regtest") as BtcNetworkName;
  if (!["regtest", "signet", "testnet", "mainnet"].includes(btcNetwork)) throw new Error("bad BTC_NETWORK");
  if (btcNetwork === "mainnet" && process.env.I_UNDERSTAND_MAINNET !== "yes")
    throw new Error("BTC_NETWORK=mainnet requires I_UNDERSTAND_MAINNET=yes (unaudited software)");
  const backend = (process.env.BTC_BACKEND ?? (btcNetwork === "regtest" ? "rpc" : "esplora")) as "rpc" | "esplora";
  return {
    evm: {
      rpcUrl: process.env.EVM_RPC_URL ?? "http://127.0.0.1:8545",
      escrow: req("ESCROW_ADDRESS") as `0x${string}`,
      startBlock: BigInt(process.env.START_BLOCK ?? "0"),
      confirmations: BigInt(process.env.EVM_CONFIRMATIONS ?? "2"),
      maxBlockRange: BigInt(process.env.EVM_MAX_BLOCK_RANGE ?? "2000"),
      pollMs: num("POLL_MS", 5000),
    },
    btc: {
      network: btcNetwork,
      backend,
      esploraUrl: process.env.ESPLORA_URL ?? defaultEsplora(btcNetwork),
      feeApiUrl: process.env.FEE_API_URL ?? defaultFeeApi(btcNetwork),
      rpcUrl: process.env.BITCOIND_RPC_URL ?? "http://127.0.0.1:18443",
      rpcUser: process.env.BITCOIND_RPC_USER ?? "",
      rpcPass: secret("BITCOIND_RPC_PASS", true) ?? "",
      rpcWatchWallet: process.env.BITCOIND_WATCH_WALLET ?? "multisea-watch",
      minConfs: num("BTC_MIN_CONFS", 3),
      feeRateFallback: num("FEE_RATE_FALLBACK", 2),
      maxFeeRate: num("MAX_FEE_RATE", 50),
      postageSats: BigInt(process.env.POSTAGE_SATS ?? "546"),
    },
    attest: {
      mode: (process.env.ATTEST_MODE ?? "dev") as "dev" | "peer",
      peerUrls: (process.env.PEER_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      peerToken: secret("PEER_AUTH_TOKEN", true),
      serverPort: num("ATTEST_SERVER_PORT", 8787),
      sigTtlSecs: num("SIG_TTL_SECS", 3600),
      autoRelease: (process.env.AUTO_RELEASE ?? "true") === "true",
    },
    contentTemplate: process.env.CONTENT_TEMPLATE_FILE,
    contentType: process.env.CONTENT_TYPE ?? "image/svg+xml",
    statePath: process.env.STATE_PATH ?? "./data/state.json",
    maxAttempts: num("MAX_ATTEMPTS", 8),
    deadlineSafetySecs: num("DEADLINE_SAFETY_SECS", 6 * 3600),
  };
}

function defaultEsplora(n: BtcNetworkName) {
  return { mainnet: "https://mempool.space/api", testnet: "https://mempool.space/testnet/api",
           signet: "https://mempool.space/signet/api", regtest: "http://127.0.0.1:3002" }[n];
}
function defaultFeeApi(n: BtcNetworkName) {
  return n === "regtest" ? "" : `${defaultEsplora(n)}/v1/fees/recommended`;
}
