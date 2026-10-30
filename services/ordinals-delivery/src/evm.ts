import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toBytes, type Hex, defineChain } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const ESCROW_ABI = parseAbi([
  "event OrderCreated(uint256 indexed orderId, bytes32 indexed collectionId, address indexed buyer, address token, uint256 amount, string btcAddress, uint64 deadline)",
  "function orders(uint256) view returns (address buyer, address token, uint128 amount, uint64 deadline, uint8 status, bytes32 collectionId, string btcAddress, bytes32 btcTxid, string inscriptionId)",
  "function attestDelivery(uint256 orderId, bytes32 btcTxid, string inscriptionId, uint256 sigDeadline, bytes[] sigs)",
  "function release(uint256 orderId)",
  "function threshold() view returns (uint256)",
  "function isAttester(address) view returns (bool)",
  "function btcNetwork() view returns (uint8)",
  "function paused() view returns (bool)",
  "error BadConfig()", "error NotAccepted()", "error SoldOut()", "error BadStatus()", "error TooEarly()",
  "error TooLate()", "error BadSigs()", "error InscriptionReused()", "error NotAuthorized()", "error WalletLimit()",
]);
export const STATUS = ["None", "Pending", "Attested", "Released", "Refunded", "Disputed"] as const;

export type AttestMsg = { orderId: bigint; btcTxid: Hex; inscriptionId: string; sigDeadline: bigint };

/** Must match SketchEscrow: EIP712("MultiSeaOrdinalEscrow","1") +
 *  Attest(uint256 orderId,bytes32 btcTxid,bytes32 inscriptionIdHash,uint256 deadline) */
export function typedData(chainId: number, escrow: Hex, m: AttestMsg) {
  return {
    domain: { name: "MultiSeaOrdinalEscrow", version: "1", chainId, verifyingContract: escrow },
    types: { Attest: [
      { name: "orderId", type: "uint256" }, { name: "btcTxid", type: "bytes32" },
      { name: "inscriptionIdHash", type: "bytes32" }, { name: "deadline", type: "uint256" } ] },
    primaryType: "Attest" as const,
    message: { orderId: m.orderId, btcTxid: m.btcTxid, inscriptionIdHash: keccak256(toBytes(m.inscriptionId)), deadline: m.sigDeadline },
  };
}
export async function signAttestation(acct: PrivateKeyAccount, chainId: number, escrow: Hex, m: AttestMsg) {
  return acct.signTypedData(typedData(chainId, escrow, m));
}
/** bitcoin txid (display hex) -> bytes32 exactly as shown by explorers */
export const txidToBytes32 = (txid: string) => `0x${txid}` as Hex;

export async function makeEvm(rpcUrl: string) {
  const pub0 = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await pub0.getChainId();
  const chain = defineChain({ id: chainId, name: `evm-${chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                              rpcUrls: { default: { http: [rpcUrl] } } });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = (acct: PrivateKeyAccount) => createWalletClient({ account: acct, chain, transport: http(rpcUrl) });
  return { pub, wallet, chainId, chain };
}
export const account = (pk: string) => privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
