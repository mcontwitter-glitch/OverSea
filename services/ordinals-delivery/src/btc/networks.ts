import { NETWORK, TEST_NETWORK } from "@scure/btc-signer";
export type BtcNetworkName = "regtest" | "signet" | "testnet" | "mainnet";
export const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
export function btcNet(n: BtcNetworkName) {
  return n === "mainnet" ? NETWORK : n === "regtest" ? REGTEST : TEST_NETWORK;
}
/** Matches SketchEscrow.btcNetwork codes. */
export const CONTRACT_BTC_NETWORK: Record<BtcNetworkName, number> = { mainnet: 0, testnet: 1, signet: 1, regtest: 2 };
