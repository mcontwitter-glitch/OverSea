# MultiSeaOrdinalEscrow: free security pass (B1), 2026-10-30

Scope: `src/launchpad/ordinals/{MultiSeaOrdinalEscrow,BtcSpv,Bech32m}.sol`. No paid audit (BIG decision Q4). Local only.

## Tests
- Forge: 119/119 across 12 suites. The ordinals file has 48: 39 unit and fuzz tests, 3 SPV tests against a real mainnet block (973775), 5 BIP-350 vectors, and 1 invariant suite (4 invariants, 256 runs × 500 depth = 128,000 calls, 0 reverts).
  The invariants are: escrow balance == open orders; at most one settlement per order; the per-wallet limit holds; conservation of USDC.
- Service unit tests: 10/10. E2E (bitcoind regtest + anvil): PASS, with SPV-verified delivery at 3 confs.

## Slither: 1 High, 8 Medium, 3 Low, 12 Informational. All triaged; none need a code change.
| Finding | Verdict |
|---|---|
| High reentrancy-balance (`createOrder`) | False positive: `nonReentrant`, allowlisted tokens only, and a balance-delta check after `transferFrom`. |
| Medium incorrect-equality | A bytes32 hash compare (Merkle root / txid) is meant to be exact. |
| Medium uninitialized-local ×7 | Zero-init is intended (loop accumulators / counters). |
| Low timestamp ×3 | Deadline comparisons; a few seconds of miner skew don't matter against a 6h window. |
| Informational ×12 | Naming, assembly in SPV hashing, low-level calls, solc version. Accepted. |

## Aderyn: 1 High, 9 Low
| Finding | Verdict |
|---|---|
| High eth-send-unchecked-address | ERC-20 transfers to buyer/artist/fee/btcOps by design; the recipients are set by the owner or are the buyer. |
| Low centralization | Owner controls are kept (BIG, B9). |
| Low literals / require-in-loop / push0 / nonReentrant-not-first | Style only; Base supports PUSH0. Accepted. |

## Not covered by free tools
- The BTC hot key that funds inscriptions is online. Keep its balance small, use 0600 key files, and run it on a separate host from the attester.
- Fee bumping (RBF/CPFP) is unit-tested only and not exercised in e2e.
- Not yet run on signet or testnet.
